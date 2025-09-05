const express = require('express');
const path = require('path');
const app = express();

// Serve static files from client directory
app.use(express.static(path.join(__dirname, '../client')));

// Handle all routes by serving index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Frontend dashboard running on port ${PORT}`);
});