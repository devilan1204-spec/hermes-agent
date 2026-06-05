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

  const close = (next: boolean) => {
    if (!next) {
      setText('')
    }

    onOpenChange(next)
  }

  // Fire-and-forget: the broadcast boots each profile's backend sequentially
  // (can take a few seconds across many profiles), so dispatch and close right
  // away — progress comes back as toasts rather than a blocking spinner.
  const send = () => {
    const body = text.trim()

    if (!body) {
      return
    }

    triggerHaptic('success')
    void sendToAllProfiles(body)
    close(false)
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
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              send()
            } else if (event.key === 'Escape') {
              close(false)
            }
          }}
          placeholder="Message every profile…"
          rows={4}
          value={text}
        />
        <DialogFooter>
          <Button onClick={() => close(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={!text.trim()} onClick={send} type="button">
            Send to all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
