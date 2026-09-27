const express = require("express");
const multer = require("multer");
const { analyzeLua } = require("./analyzer");

const app = express();

const upload = multer({
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Lua Study Analyzer</title>
      </head>
      <body>
        <h1>Lua Study Analyzer</h1>

        <form action="/analyze"
              method="POST"
              enctype="multipart/form-data">

          <input
            type="file"
            name="file"
            accept=".lua,.luau,.txt"
            required
          />

          <button type="submit">
            Analyze
          </button>

        </form>
      </body>
    </html>
  `);
});

app.post("/analyze", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "No file uploaded"
    });
  }

  const source = req.file.buffer.toString("utf8");

  try {
    const result = analyzeLua(source);

    res.json({
      success: true,
      filename: req.file.originalname,
      analysis: result
    });
  } catch (error) {
    res.status(500).json({
      error: "Analysis failed"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
