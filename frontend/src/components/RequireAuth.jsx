import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import Spinner from './Spinner'
import ConfigNotice from './ConfigNotice'

export default function RequireAuth({ children }) {
  const { user, loading, configured, demo } = useAuth()
  const location = useLocation()

  if (!configured && !demo) return <ConfigNotice />
  if (loading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner label="Restoring your session" />
      </div>
    )
  }
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname }} />

  return children
}
