(async () => {
  try {
    await import("./server.js");
  } catch (error) {
    console.error("Application startup failed:");
    console.error(error);
    process.exit(1);
  }
})();
