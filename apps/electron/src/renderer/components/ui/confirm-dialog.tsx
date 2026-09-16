import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  loadingLabel?: string
  onConfirm: () => void | Promise<void>
  /** false 时阻止 Radix 自动关闭，由父组件在确认成功后更新 open。 */
  closeOnConfirm?: boolean
  loading?: boolean
  variant?: 'destructive' | 'default'
  children?: React.ReactNode
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  loadingLabel,
  onConfirm,
  closeOnConfirm = true,
  loading = false,
  variant = 'destructive',
  children,
}: ConfirmDialogProps): React.ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v && !loading) onOpenChange(v) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {(description || children) && (
            <AlertDialogDescription asChild={!!children}>
              {children ?? description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              if (!closeOnConfirm) event.preventDefault()
              void onConfirm()
            }}
            disabled={loading}
            className={variant === 'destructive' ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
          >
            {loading ? (loadingLabel ?? confirmLabel) : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
