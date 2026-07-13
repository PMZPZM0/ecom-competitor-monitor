function responseFilename(response: Response, fallbackName: string) {
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ''))
    } catch {
      // Fall back to the caller-provided name for malformed headers.
    }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName
}

async function responseError(response: Response) {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { message?: string; error?: string }
    return body.message || body.error || text
  } catch {
    return text
  }
}

export async function downloadFile(path: string, fallbackName: string) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(await responseError(response) || `下载失败：${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error('下载内容为空，请重新抓取后再试。')
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = responseFilename(response, fallbackName)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
  return { bytes: blob.size, filename: link.download }
}
