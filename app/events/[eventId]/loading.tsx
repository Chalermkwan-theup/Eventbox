export default function LoadingEventDetail() {
  return (
    <div className="container" aria-hidden="true">
      <div className="card">
        <div className="skeleton skeleton-line skeleton-line--title" />
        <div className="skeleton skeleton-line skeleton-line--short" />
        <div className="skeleton skeleton-line" />
      </div>
      <div className="card">
        <div className="skeleton skeleton-line skeleton-line--title" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
      </div>
    </div>
  );
}
