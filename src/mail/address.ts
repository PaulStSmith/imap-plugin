import { AddressObject } from "mailparser";

interface FlatAddress {
  name?: string;
  address?: string;
}

type AddressInput = AddressObject | AddressObject[] | FlatAddress | FlatAddress[];

function formatAddress(address: FlatAddress): string {
  if (address.name && address.address) {
    return `${address.name} <${address.address}>`;
  }

  return address.address ?? address.name ?? "";
}

export function addressesToStrings(addresses?: AddressInput): string[] {
  const values = Array.isArray(addresses) ? addresses : addresses ? [addresses] : [];
  return values.flatMap((value) => {
    if ("value" in value) {
      return value.value.map(formatAddress).filter(Boolean);
    }

    return [formatAddress(value)].filter(Boolean);
  });
}
