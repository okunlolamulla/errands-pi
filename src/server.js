import 'dotenv/config'; // must be first so the other modules see the environment
const { default: app } = await import('./app.js');

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Errand Boys API listening on :${port}`));
