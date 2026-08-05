import { X } from 'lucide-react'

export interface ModalProps {
  title: string
  onClose(): void
  children: React.ReactNode
}

export function Modal({ title, onClose, children }: ModalProps): React.ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose}><X size={18}/></button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  )
}
