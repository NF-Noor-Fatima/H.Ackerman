# Campus Rumors - Anonymous News Sharing

A lightweight, privacy-first web application for anonymous campus news and rumor sharing with decentralized trust scoring.

## 🎯 Philosophy

- **Privacy First**: No login, no personal data, no tracking
- **Decentralized Trust**: Truth emerges from community consensus, not admins
- **Anonymous Participation**: Browser-based tokens with client-side hashing
- **Simple & Extensible**: Prototype-friendly architecture for academic research

## 🚀 Features

- **Anonymous Token System**: Auto-generated in browser, hashed before transmission
- **Rumor Submission**: Share campus news without revealing identity
- **Decentralized Voting**: Verify or dispute rumors to build trust scores
- **Trust Labels**: "Leaning True", "Uncertain", "Leaning False" based on votes
- **No Admin Moderation**: Truth is determined by the community
- **Premium UI**: Glassmorphism, dark mode, smooth animations

## 🛠️ Tech Stack

- **Backend**: Express.js + SQLite
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Security**: SHA-256 token hashing
- **Database**: File-based SQLite (rumors.db)

## 📦 Installation

1. **Clone or navigate to project directory**

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

4. **Open in browser**: http://localhost:3000

## 🔧 Development

```bash
npm run dev  # Auto-reload on file changes
```

## 📡 API Endpoints

### GET /api/rumors
Returns all rumors ordered by timestamp (newest first).

**Response**:
```json
{
  "success": true,
  "rumors": [
    {
      "id": 1,
      "content": "New cafeteria opening next week!",
      "timestamp": 1707285600000,
      "verify_count": 5,
      "dispute_count": 1,
      "trust_score": 0.67
    }
  ]
}
```

### POST /api/rumors
Submit a new rumor.

**Request**:
```json
{
  "content": "Rumor text (max 500 chars)",
  "hashedToken": "64-char hex SHA-256 hash"
}
```

**Response**:
```json
{
  "success": true,
  "rumor": { /* rumor object */ }
}
```

### POST /api/vote
Vote on a rumor (verify or dispute).

**Request**:
```json
{
  "rumorId": 1,
  "hashedToken": "64-char hex SHA-256 hash",
  "voteType": "verify" // or "dispute"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Vote recorded",
  "verify_count": 6,
  "dispute_count": 1,
  "trust_score": 0.71
}
```

## 🔒 Privacy & Security

- **No Personal Data**: No names, emails, IP addresses, or user agents collected
- **Token Hashing**: Raw tokens never leave the browser; only SHA-256 hashes sent to server
- **Local Storage**: Tokens persist in browser's localStorage (cleared only by user)
- **One Vote Per Token**: Database constraint prevents duplicate votes
- **No Authentication**: System relies on browser-based anonymous tokens

## 📊 Trust Score Algorithm

```javascript
trust_score = (verify_count - dispute_count) / (verify_count + dispute_count)
```

**Labels**:
- `score > 0.3` → **Leaning True**
- `-0.3 ≤ score ≤ 0.3` → **Uncertain**
- `score < -0.3` → **Leaning False**
- `total_votes = 0` → **No Votes Yet**

## 🎨 Design Features

- Dark mode with animated gradient background
- Glassmorphism effects with backdrop blur
- Smooth micro-animations on interactions
- Color-coded trust labels
- Responsive mobile-first design
- Custom Google Fonts (Inter)

## 🧪 Testing

1. **Submit a rumor**: Should appear in the list immediately
2. **Vote verify/dispute**: Should update counts and trust label
3. **Duplicate vote**: Should be rejected with error message
4. **Clear localStorage**: Should generate new token (can vote again)
5. **Check DevTools**: Verify no personal data in Network tab

## 🚀 Future Extensions

- WebSocket for real-time updates
- Rumor expiration (time-to-live)
- Trending/popular sorting
- Category tags
- Rate limiting per token
- Export/import rumors (JSON)
- Dark web deployment for true anonymity

## ⚠️ Limitations

This is a **prototype** for academic research. Production deployment would need:
- Rate limiting to prevent spam
- Content moderation for illegal content
- DDoS protection
- HTTPS for token security
- Database backups and scaling

## 📝 License

MIT License - Free for educational and research purposes

## 🤝 Contributing

This is a prototype for learning. Feel free to extend it for your own research!

---

**Built with privacy, decentralization, and simplicity in mind** 🎭
