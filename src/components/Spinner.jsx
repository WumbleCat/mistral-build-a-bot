import { LoaderCircle } from 'lucide-react'

export default function Spinner({ label, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 text-sm text-ink-400 ${className}`}>
      <LoaderCircle className="size-4 animate-spin text-flame-400" />
      {label && <span>{label}</span>}
    </div>
  )
}
