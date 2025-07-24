import app from './sec-server';

// Start the server
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`SEC Agent server running on port ${PORT}`);
});
