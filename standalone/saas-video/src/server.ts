import { createApp, mountRoutes } from './app.js'
import { env } from './shared/config/env.js'

const app = createApp()
mountRoutes(app, { prefix: '' })

app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT}`)
})
