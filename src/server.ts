import { env } from './shared/config/env.js'
import { app } from './app.js'

app.listen(env.PORT, () => {
  console.warn(`Server running on port ${env.PORT}`)
})
