from cellfence_fixture.core.public import normalize_order as _normalize_order


def submit_order(order_id):
    return {"order_id": _normalize_order(order_id), "accepted": True}
