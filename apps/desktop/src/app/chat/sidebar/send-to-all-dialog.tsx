import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { triggerHaptic } from '@/lib/haptics'
import { sendToAllProfiles } from '@/store/profile'

interface SendToAllDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// A bare composer that fans one message out to every profile at once. Closes
// itself the moment the broadcast is dispatched — the turns run in the
// background, so there's no point holding the user on N backends.
export function SendToAllDialog({ onOpenChange, open }: SendToAllDialogProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const close = (next: boolean) => {
    if (!next) {
      setText('')
    }

    onOpenChange(next)
  }

  const send = async () => {
    const body = text.trim()

    if (!body || sending) {
      return
    }

    setSending(true)
    triggerHaptic('success')

    try {
      await sendToAllProfiles(body)
      close(false)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to all profiles</DialogTitle>
          <DialogDescription>Opens a fresh session in every profile and sends this message to each. ⌘↵ to send.</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          disabled={sending}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            } else if (event.key === 'Escape') {
              close(false)
            }
          }}
          placeholder="Message every profile…"
          rows={4}
          value={text}
        />
        <DialogFooter>
          <Button disabled={sending} onClick={() => close(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={!text.trim() || sending} onClick={() => void send()} type="button">
            {sending ? 'Sending…' : 'Send to all'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
