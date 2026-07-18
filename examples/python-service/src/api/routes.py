from src.domain.public import calculate_total
from src.infra.public import Database


def handle_checkout(items):
    total = calculate_total(items)
    return Database().save_order(total)
