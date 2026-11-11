const express = require('express');
const path = require('path');
const app = express();

// This tells your server to show your index.html file to visitors
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});