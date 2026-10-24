(async () => {
  try {
    const { default: app } = await import("./server.js");
    const port = Number(process.env.PORT || 3000);

    app.listen(port, "0.0.0.0", () => {
      console.log(`Server listening on port ${port}`);
    });
  } catch (error) {
    console.error("Application startup failed:");
    console.error(error);
    process.exit(1);
  }
})();
