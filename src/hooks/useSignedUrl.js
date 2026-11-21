import { useEffect, useState } from 'react'
import { signedImageUrl } from '../lib/api'

/** Resolve a private Storage path to a temporary URL the <img> tag can use. */
export default function useSignedUrl(path) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let active = true
    if (!path) {
      setUrl(null)
      return
    }
    signedImageUrl(path).then((next) => {
      if (active) setUrl(next)
    })
    return () => {
      active = false
    }
  }, [path])

  return url
}
