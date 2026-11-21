import { ImageIcon } from 'lucide-react'
import useSignedUrl from '../hooks/useSignedUrl'

export default function DeviceImage({ path, alt, className = '' }) {
  const url = useSignedUrl(path)

  if (!url) {
    return (
      <div className={`skeleton grid place-items-center ${className}`}>
        <ImageIcon className="size-6 text-ink-600" />
      </div>
    )
  }
  return <img src={url} alt={alt} className={className} loading="lazy" />
}
