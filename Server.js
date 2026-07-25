const http = require("http");
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Server is up");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Test server running on port ${PORT}`);
});