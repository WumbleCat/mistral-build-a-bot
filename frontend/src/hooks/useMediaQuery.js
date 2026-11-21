import { useEffect, useState } from 'react'

/**
 * Media query as state.
 *
 * Needed where a CSS-only `hidden` would still mount the component -- two WebGL
 * canvases would both allocate a GPU context even though only one is visible.
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = (e) => setMatches(e.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}
