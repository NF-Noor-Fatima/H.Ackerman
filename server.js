const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite database
let db;
const dbPath = 'rumors.db';

async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
    CREATE TABLE IF NOT EXISTS rumors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      verify_count INTEGER DEFAULT 0,
      dispute_count INTEGER DEFAULT 0,
      weighted_verify REAL DEFAULT 0,
      weighted_dispute REAL DEFAULT 0,
      trust_score REAL DEFAULT 0,
      is_deleted INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      submitter_token TEXT,
      status TEXT DEFAULT 'ACTIVE'
    )
  `);

    // Migrate rumors table if it exists but is missing columns
    const rumorsColumns = [
        "weighted_verify REAL DEFAULT 0",
        "weighted_dispute REAL DEFAULT 0",
        "is_deleted INTEGER DEFAULT 0",
        "is_archived INTEGER DEFAULT 0",
        "submitter_token TEXT",
        "status TEXT DEFAULT 'ACTIVE'"
    ];
    rumorsColumns.forEach(col => {
        try {
            db.run(`ALTER TABLE rumors ADD COLUMN ${col}`);
        } catch (e) {
            // Column likely already exists
        }
    });

    db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rumor_id INTEGER NOT NULL,
      hashed_token TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      vote_weight REAL DEFAULT 1.0,
      confidence REAL DEFAULT 1.0,
      UNIQUE(rumor_id, hashed_token),
      FOREIGN KEY (rumor_id) REFERENCES rumors(id)
    )
  `);

    // Migrate votes table
    const votesColumns = ["vote_weight REAL DEFAULT 1.0", "confidence REAL DEFAULT 1.0"];
    votesColumns.forEach(col => {
        try {
            db.run(`ALTER TABLE votes ADD COLUMN ${col}`);
        } catch (e) {
            // Column likely already exists
        }
    });

    db.run(`
    CREATE TABLE IF NOT EXISTS user_credibility (
      hashed_token TEXT PRIMARY KEY,
      credibility REAL DEFAULT 0.1,
      total_votes INTEGER DEFAULT 0,
      aligned_votes INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_updated INTEGER NOT NULL
    )
  `);

    saveDatabase();
}

// Save database to file
function saveDatabase() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

// Utility: Validate hashed token (should be 64-char hex SHA-256)
function isValidHashedToken(token) {
    return /^[a-f0-9]{64}$/i.test(token);
}

// Utility: Get or create user credibility
function getUserCredibility(hashedToken) {
    const stmt = db.prepare('SELECT credibility FROM user_credibility WHERE hashed_token = ?');
    stmt.bind([hashedToken]);

    if (stmt.step()) {
        const result = stmt.getAsObject();
        stmt.free();
        return result.credibility;
    }

    stmt.free();

    // Create new user with default credibility = 0.1
    const now = Date.now();
    db.run(`
    INSERT INTO user_credibility (hashed_token, credibility, total_votes, aligned_votes, created_at, last_updated)
    VALUES (?, 0.1, 0, 0, ?, ?)
  `, [hashedToken, now, now]);

    saveDatabase();
    return 0.1;
}

// Utility: Update credibility for all voters when rumor reaches consensus threshold
function updateVoterCredibility(rumorId) {
    const CONSENSUS_THRESHOLD = 5; // Minimum votes to trigger credibility update

    // Get rumor details
    const rumorStmt = db.prepare('SELECT verify_count, dispute_count, trust_score FROM rumors WHERE id = ?');
    rumorStmt.bind([rumorId]);
    const hasRumor = rumorStmt.step();
    const rumor = hasRumor ? rumorStmt.getAsObject() : null;
    rumorStmt.free();

    if (!rumor) return;

    const totalVotes = rumor.verify_count + rumor.dispute_count;

    if (totalVotes < CONSENSUS_THRESHOLD) {
        return; // Not enough votes to determine consensus
    }

    // Determine consensus direction
    const consensusDirection = rumor.trust_score > 0 ? 'verify' : 'dispute';

    // Get all voters for this rumor with their confidence weights
    const votesStmt = db.prepare('SELECT hashed_token, vote_type, confidence FROM votes WHERE rumor_id = ?');
    votesStmt.bind([rumorId]);

    const votersToUpdate = [];
    while (votesStmt.step()) {
        votersToUpdate.push(votesStmt.getAsObject());
    }
    votesStmt.free();

    // Now update them outside the votesStmt loop to avoid "Statement closed" issues
    votersToUpdate.forEach(vote => {
        const aligned = vote.vote_type === consensusDirection;
        const highConfidence = vote.confidence > 0.7;
        updateUserCredibility(vote.hashed_token, aligned, highConfidence, false); // Don't save inside loop
    });

    saveDatabase();
}

// Utility: Update user credibility
function updateUserCredibility(hashedToken, aligned, highConfidence, shouldSave = true) {
    const CREDIBILITY_INCREASE = 0.02;
    const CREDIBILITY_MULTIPLIER = 0.8;
    const MIN_CREDIBILITY = 0.05;
    const MAX_CREDIBILITY = 3.0;

    const stmt = db.prepare('SELECT credibility, total_votes, aligned_votes FROM user_credibility WHERE hashed_token = ?');
    stmt.bind([hashedToken]);
    const hasUser = stmt.step();
    const user = hasUser ? stmt.getAsObject() : null;
    stmt.free();

    if (!user) return;

    let newCredibility = user.credibility;

    if (aligned) {
        newCredibility += CREDIBILITY_INCREASE;
    } else if (highConfidence) {
        newCredibility *= CREDIBILITY_MULTIPLIER;
    } else {
        newCredibility -= CREDIBILITY_INCREASE / 2;
    }

    newCredibility = Math.max(MIN_CREDIBILITY, Math.min(MAX_CREDIBILITY, newCredibility));

    const newTotalVotes = user.total_votes + 1;
    const newAlignedVotes = user.aligned_votes + (aligned ? 1 : 0);

    db.run(`
    UPDATE user_credibility 
    SET credibility = ?, total_votes = ?, aligned_votes = ?, last_updated = ?
    WHERE hashed_token = ?
  `, [newCredibility, newTotalVotes, newAlignedVotes, Date.now(), hashedToken]);

    if (shouldSave) saveDatabase();
}

// API: Get all rumors
app.get('/api/rumors', (req, res) => {
    try {
        const now = Date.now();
        const INACTIVITY_THRESHOLD = 7 * 30.44 * 24 * 60 * 60 * 1000; // ~7 months
        const LOW_TRUST_THRESHOLD = -0.8;
        const USER_CLEANUP_THRESHOLD = 365 * 24 * 60 * 60 * 1000; // 365 days

        // One-time manipulation for SEECS rumor (requested by user)
        const eighteenMonthsAgo = now - (18 * 30.44 * 24 * 60 * 60 * 1000);
        db.run(`
            UPDATE rumors 
            SET timestamp = ?, status = 'ARCHIVED', is_archived = 1 
            WHERE content LIKE '%SEECS is built on top of a graveyard%'
        `, [eighteenMonthsAgo]);

        // Auto-archive check
        db.run(`
            UPDATE rumors 
            SET status = 'ARCHIVED', is_archived = 1 
            WHERE status = 'ACTIVE' 
            AND (
                (? - timestamp > ?) OR 
                (trust_score < ?)
            )
        `, [now, INACTIVITY_THRESHOLD, LOW_TRUST_THRESHOLD]);

        // Inactive User Cleanup (Optimization)
        const thresholdDate = now - USER_CLEANUP_THRESHOLD;

        // 1. Remove users inactive for > 1 year
        db.run("DELETE FROM user_credibility WHERE last_updated < ?", [thresholdDate]);

        // 2. Remove orphaned votes from deleted users to keep DB small
        db.run(`
            DELETE FROM votes 
            WHERE hashed_token NOT IN (SELECT hashed_token FROM user_credibility)
        `);

        saveDatabase();

        const stmt = db.prepare(`
      SELECT id, content, timestamp, verify_count, dispute_count, trust_score, submitter_token, status
      FROM rumors
      WHERE is_deleted = 0
      ORDER BY status ASC, timestamp DESC
    `);

        const rumors = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            rumors.push(row);
        }
        stmt.free();

        res.json({ success: true, rumors });
    } catch (error) {
        console.error('Error fetching rumors:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch rumors' });
    }
});

// API: Submit a new rumor
app.post('/api/rumors', (req, res) => {
    try {
        const { content, hashedToken, confidenceWeight } = req.body;

        // Validate input
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Content is required' });
        }

        if (!hashedToken || !isValidHashedToken(hashedToken)) {
            return res.status(400).json({ success: false, error: 'Invalid token' });
        }

        if (content.length > 500) {
            return res.status(400).json({ success: false, error: 'Content too long (max 500 characters)' });
        }

        if (confidenceWeight === undefined || typeof confidenceWeight !== 'number' || confidenceWeight < 0.1 || confidenceWeight > 1.0) {
            return res.status(400).json({ success: false, error: 'Valid confidence weight is required' });
        }

        // Get submitter credibility
        const userCredibility = getUserCredibility(hashedToken);

        // Initial trust score = Credibility × Confidence Weight (Direction +1 for submission)
        const initialTrustScore = userCredibility * confidenceWeight;

        // Insert rumor
        const timestamp = Date.now();
        db.run(`
      INSERT INTO rumors (content, timestamp, verify_count, dispute_count, weighted_verify, weighted_dispute, trust_score, is_deleted, is_archived, submitter_token, status)
      VALUES (?, ?, 0, 0, ?, 0, ?, 0, 0, ?, 'ACTIVE')
    `, [content.trim(), timestamp, initialTrustScore, initialTrustScore, hashedToken]);

        saveDatabase();

        // Get last insert ID
        const stmt = db.prepare('SELECT last_insert_rowid() as id');
        stmt.step();
        const result = stmt.getAsObject();
        stmt.free();

        res.json({
            success: true,
            rumor: {
                id: result.id,
                content: content.trim(),
                timestamp,
                verify_count: 0,
                dispute_count: 0,
                trust_score: initialTrustScore,
                submitter_token: hashedToken,
                status: 'ACTIVE'
            }
        });
    } catch (error) {
        console.error('Error submitting rumor:', error);
        res.status(500).json({ success: false, error: 'Failed to submit rumor' });
    }
});

// API: Vote on a rumor
app.post('/api/vote', (req, res) => {
    try {
        const { rumorId, hashedToken, voteType, confidenceWeight } = req.body;

        // Validate input
        if (!rumorId || typeof rumorId !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid rumor ID' });
        }

        if (!hashedToken || !isValidHashedToken(hashedToken)) {
            return res.status(400).json({ success: false, error: 'Invalid token' });
        }

        if (!voteType || !['verify', 'dispute'].includes(voteType)) {
            return res.status(400).json({ success: false, error: 'Vote type must be "verify" or "dispute"' });
        }

        if (!confidenceWeight || typeof confidenceWeight !== 'number' || confidenceWeight < 0.1 || confidenceWeight > 1.0) {
            return res.status(400).json({ success: false, error: 'Invalid confidence weight' });
        }

        // Check if rumor exists
        const rumorStmt = db.prepare('SELECT * FROM rumors WHERE id = ? AND is_deleted = 0 AND is_archived = 0');
        rumorStmt.bind([rumorId]);
        const rumorExists = rumorStmt.step();
        rumorStmt.free();

        if (!rumorExists) {
            return res.status(404).json({ success: false, error: 'Rumor not found or archived' });
        }

        // NEW: Prevents owner from voting
        const stmtOwner = db.prepare('SELECT submitter_token FROM rumors WHERE id = ?');
        stmtOwner.bind([rumorId]);
        stmtOwner.step();
        const rumor = stmtOwner.getAsObject();
        stmtOwner.free();

        if (rumor.submitter_token === hashedToken) {
            return res.status(403).json({ success: false, error: "You cannot vote on your own rumor" });
        }

        // Check if user already voted
        const voteStmt = db.prepare('SELECT * FROM votes WHERE rumor_id = ? AND hashed_token = ?');
        voteStmt.bind([rumorId, hashedToken]);
        const existingVote = voteStmt.step();
        voteStmt.free();

        if (existingVote) {
            return res.status(400).json({ success: false, error: 'You have already voted on this rumor' });
        }

        // Get user credibility (creates new user if doesn't exist)
        const userCredibility = getUserCredibility(hashedToken);

        // Calculate vote impact: User Credibility × Confidence Weight × Vote Direction
        const voteDirection = voteType === 'verify' ? 1 : -1;
        const voteImpact = userCredibility * confidenceWeight * voteDirection;

        console.log(`\n=== VOTE DEBUG ===`);
        console.log(`User Credibility: ${userCredibility}`);
        console.log(`Confidence Weight: ${confidenceWeight}`);
        console.log(`Vote Type: ${voteType} (direction: ${voteDirection})`);
        console.log(`Vote Impact: ${voteImpact}`);

        // Insert vote
        const timestamp = Date.now();
        db.run(`
      INSERT INTO votes (rumor_id, hashed_token, vote_type, timestamp, vote_weight, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [rumorId, hashedToken, voteType, timestamp, userCredibility, confidenceWeight]);

        // Update rumor vote counts (raw)
        const countColumn = voteType === 'verify' ? 'verify_count' : 'dispute_count';
        db.run(`UPDATE rumors SET ${countColumn} = ${countColumn} + 1 WHERE id = ?`, [rumorId]);

        // Get current trust score
        const currentStmt = db.prepare('SELECT trust_score FROM rumors WHERE id = ?');
        currentStmt.bind([rumorId]);
        currentStmt.step();
        const current = currentStmt.getAsObject();
        currentStmt.free();

        console.log(`Old Trust Score: ${current.trust_score}`);

        // Update trust score: Old Trust Score + Vote Impact
        const newTrustScore = current.trust_score + voteImpact;
        db.run('UPDATE rumors SET trust_score = ? WHERE id = ?', [newTrustScore, rumorId]);

        console.log(`New Trust Score: ${newTrustScore}`);
        console.log(`=================\n`);

        // Get updated counts
        const updatedStmt = db.prepare('SELECT verify_count, dispute_count, trust_score FROM rumors WHERE id = ?');
        updatedStmt.bind([rumorId]);
        updatedStmt.step();
        const updatedRumor = updatedStmt.getAsObject();
        updatedStmt.free();

        saveDatabase();

        // Update voter credibility if consensus threshold is reached
        updateVoterCredibility(rumorId);

        res.json({
            success: true,
            message: 'Vote recorded',
            verify_count: updatedRumor.verify_count,
            dispute_count: updatedRumor.dispute_count,
            trust_score: updatedRumor.trust_score,
            your_credibility: userCredibility
        });
    } catch (error) {
        console.error('Error recording vote:', error);
        res.status(500).json({ success: false, error: 'Failed to record vote' });
    }
});

// API: Get user credibility
app.get('/api/credibility/:hashedToken', (req, res) => {
    try {
        const { hashedToken } = req.params;

        if (!isValidHashedToken(hashedToken)) {
            return res.status(400).json({ success: false, error: 'Invalid token' });
        }

        const credibility = getUserCredibility(hashedToken);

        const stmt = db.prepare('SELECT credibility, total_votes, aligned_votes FROM user_credibility WHERE hashed_token = ?');
        stmt.bind([hashedToken]);
        stmt.step();
        const user = stmt.getAsObject();
        stmt.free();

        res.json({
            success: true,
            credibility: user.credibility,
            total_votes: user.total_votes,
            aligned_votes: user.aligned_votes,
            alignment_rate: user.total_votes > 0 ? (user.aligned_votes / user.total_votes) : 0
        });
    } catch (error) {
        console.error('Error fetching credibility:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch credibility' });
    }
});

// API: Delete a rumor (Submitter only, with -0.1 penalty)
app.post('/api/delete', (req, res) => {
    try {
        const { rumorId, hashedToken } = req.body;

        if (!rumorId || !hashedToken) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        // Check if rumor exists and if the user is the owner
        const stmt = db.prepare('SELECT submitter_token, is_deleted FROM rumors WHERE id = ?');
        stmt.bind([rumorId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ success: false, error: 'Rumor not found' });
        }

        const rumor = stmt.getAsObject();
        stmt.free();

        if (rumor.submitter_token !== hashedToken) {
            return res.status(403).json({ success: false, error: 'Only the original submitter can delete this rumor' });
        }

        if (rumor.is_deleted) {
            return res.status(400).json({ success: false, error: 'Rumor is already deleted' });
        }

        // 1. Mark as deleted
        db.run("UPDATE rumors SET is_deleted = 1 WHERE id = ?", [rumorId]);

        // 2. Apply -0.1 credibility penalty
        const MIN_CREDIBILITY = 0.05;
        const credStmt = db.prepare('SELECT credibility FROM user_credibility WHERE hashed_token = ?');
        credStmt.bind([hashedToken]);
        if (credStmt.step()) {
            const currentCred = credStmt.getAsObject().credibility;
            const newCred = Math.max(MIN_CREDIBILITY, currentCred - 0.1);

            db.run(`
                UPDATE user_credibility 
                SET credibility = ?, last_updated = ?
                WHERE hashed_token = ?
            `, [newCred, Date.now(), hashedToken]);
            console.log(`Penalty applied to owner: ${hashedToken}. New Credibility: ${newCred}`);
        }
        credStmt.free();

        saveDatabase();

        res.json({ success: true, message: 'Rumor deleted and penalty applied' });
    } catch (error) {
        console.error('Error deleting rumor:', error);
        res.status(500).json({ success: false, error: 'Failed to delete rumor' });
    }
});

// Start server
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`✓ Server running at http://localhost:${PORT}`);
        console.log(`✓ Database initialized with credibility system`);
        console.log(`✓ Ready to accept anonymous rumors with weighted voting`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
