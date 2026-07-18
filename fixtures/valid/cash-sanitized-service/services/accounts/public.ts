type AccountSummary = {
  accountId: string;
  availableCents: number;
};

export function getAccountSummary(accountId: string): AccountSummary {
  return {
    accountId,
    availableCents: 0,
  };
}
