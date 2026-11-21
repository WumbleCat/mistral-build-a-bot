export default function Empty({ icon: Icon, title, body, action }) {
  return (
    <div className="card grid place-items-center px-6 py-14 text-center">
      {Icon && (
        <span className="mb-4 grid size-12 place-items-center rounded-2xl border border-ink-700 bg-ink-850 text-ink-400">
          <Icon className="size-6" />
        </span>
      )}
      <h3 className="text-base font-semibold text-ink-100">{title}</h3>
      {body && <p className="mt-1.5 max-w-md text-sm text-ink-400">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
