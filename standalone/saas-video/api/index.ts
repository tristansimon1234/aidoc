import { createApp, mountRoutes } from '../src/app.js'

// Vercel serverless entry. Bundled differently from the local dev runtime
// — we expose the Express app as a default export rather than calling
// .listen(). The /api prefix matches Vercel's routing config in vercel.json.
const app = createApp()
mountRoutes(app, { prefix: '/api' })

export default app
