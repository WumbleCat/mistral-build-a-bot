import { Link } from 'react-router-dom'
import { ScanSearch } from 'lucide-react'
import Empty from '../components/Empty'

export default function NotFound() {
  return (
    <Empty
      icon={ScanSearch}
      title="Nothing here"
      body="That page does not exist. Start from a photo instead."
      action={
        <Link to="/" className="btn-primary">
          Upload a photo
        </Link>
      }
    />
  )
}
