import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { RunDashboard } from './features/run/pages/RunDashboard.js'
import { RunDetail } from './features/run/pages/RunDetail.js'
import { NewRun } from './features/run/pages/NewRun.js'

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RunDashboard />} />
        <Route path="/runs/new" element={<NewRun />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Routes>
    </BrowserRouter>
  )
}
