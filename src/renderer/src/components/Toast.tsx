import { useEffect } from 'react'
import { CircleAlert, X } from 'lucide-react'

export interface ToastProps {
  message: string
  onClose(): void
}

export function Toast({ message, onClose }: ToastProps): React.ReactElement | null {
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(onClose, 3000)
    return () => window.clearTimeout(timer)
  }, [message, onClose])

  if (!message) return null
  return (
    <div className="toast">
      <CircleAlert size={17}/>
      {message}
      <button onClick={onClose}><X size={15}/></button>
    </div>
  )
}
