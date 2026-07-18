import { getAccountSummary } from "../accounts/public";

type PaymentIntent = {
  accountId: string;
  amountCents: number;
  approved: boolean;
};

export function createPaymentIntent(accountId: string, amountCents: number): PaymentIntent {
  const account = getAccountSummary(accountId);
  return {
    accountId,
    amountCents,
    approved: account.availableCents >= amountCents,
  };
}
