"""Bounded parallel model work with ordered results and completion progress."""

from concurrent.futures import ThreadPoolExecutor, as_completed


def ordered_parallel_map(function, items, *, workers=1, on_progress=None, progress_weight=None):
    items = list(items)
    weight = progress_weight or (lambda item: 1)
    total = sum(weight(item) for item in items)
    completed_weight = 0
    if on_progress:
        on_progress(0, total)
    if workers <= 1 or len(items) <= 1:
        results = []
        for item in items:
            results.append(function(item))
            completed_weight += weight(item)
            if on_progress:
                on_progress(completed_weight, total)
        return results

    results = [None] * len(items)
    with ThreadPoolExecutor(max_workers=min(workers, 4)) as pool:
        pending = {pool.submit(function, item): index for index, item in enumerate(items)}
        for future in as_completed(pending):
            try:
                results[pending[future]] = future.result()
            except Exception:
                # An atomic stage cannot use a partial result. Stop queued work
                # instead of paying for requests whose output will be rejected.
                for unfinished in pending:
                    unfinished.cancel()
                raise
            completed_weight += weight(items[pending[future]])
            if on_progress:
                on_progress(completed_weight, total)
    return results


def chunked(items, size):
    """Bound model requests without dropping or reordering inputs."""
    if not isinstance(size, int) or size < 1:
        raise ValueError('Batch size must be a positive integer.')
    items = list(items)
    return [items[start:start + size] for start in range(0, len(items), size)]
