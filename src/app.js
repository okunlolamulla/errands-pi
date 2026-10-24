const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend files if your project has a public directory.
app.use(express.static(path.join(__dirname, "../public")));

app.get("/healthz", (req, res) => {
  res.status(200).json({
    status: "ok"
  });
});

app.get("/", (req, res) => {
  res.status(200).send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Errand Boys NG</title>
        <meta
          name="description"
          content="Errand Boys NG helps customers complete everyday errands reliably and conveniently."
        >
      </head>
      <body>
        <main>
          <h1>Errand Boys NG</h1>
          <p>Your reliable partner for everyday errands.</p>
        </main>
      </body>
    </html>
  `);
});

app.use((req, res) => {
  res.status(404).send("Page not found");
});

app.listen(PORT, HOST, () => {
  console.log(`Errand Boys NG listening on ${HOST}:${PORT}`);
});
