const express = require('express');
const path = require('path');
const app = express();

// This line tells Express to serve files from your current folder
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});