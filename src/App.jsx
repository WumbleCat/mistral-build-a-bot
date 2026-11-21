import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import Project from './pages/Project'
import SignIn from './pages/SignIn'
import NotFound from './pages/NotFound'
import RequireAuth from './components/RequireAuth'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="/signin" element={<SignIn />} />
        <Route
          path="/builds"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/builds/:id"
          element={
            <RequireAuth>
              <Project />
            </RequireAuth>
          }
        />
        <Route path="/project/:id" element={<Navigate to="/builds" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
