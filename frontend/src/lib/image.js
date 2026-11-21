/**
 * Downscale a photo in the browser before it is uploaded.
 *
 * Phone photos are 4-12 MB; the vision model only needs ~1280px on the long edge.
 * This keeps the upload fast and the analysis call well under the request size limit.
 */
const MAX_EDGE = 1280
const QUALITY = 0.85

export async function prepareImage(file, { maxEdge = MAX_EDGE } = {}) {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not an image. Use a JPG, PNG or WebP photo.')
  }

  // HEIC and friends can't be decoded by every browser -- send them as-is.
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { file, width: null, height: null, previewUrl: URL.createObjectURL(file) }
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  // Already small and already a web format: no re-encode needed.
  if (scale === 1 && file.size < 1_500_000 && /jpeg|png|webp/.test(file.type)) {
    bitmap.close?.()
    return { file, width, height, previewUrl: URL.createObjectURL(file) }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
  if (!blob) return { file, width, height, previewUrl: URL.createObjectURL(file) }

  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  const resized = new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })

  return { file: resized, width, height, previewUrl: URL.createObjectURL(resized) }
}
