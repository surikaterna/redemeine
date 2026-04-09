export type ReverseSemanticsOperation = {
  readonly aggregateType: string;
  readonly aggregateId: string;
};

export type ReverseSemanticsContract = {
  readonly adds: readonly ReverseSemanticsOperation[];
  readonly removes: readonly ReverseSemanticsOperation[];
};

export function createReverseSemanticsContract(
  options: {
    readonly adds?: readonly ReverseSemanticsOperation[];
    readonly removes?: readonly ReverseSemanticsOperation[];
  } = {}
): ReverseSemanticsContract {
  return {
    adds: [...(options.adds ?? [])],
    removes: [...(options.removes ?? [])]
  };
}

export function reverseSemanticsContract(
  adds: readonly ReverseSemanticsOperation[] = [],
  removes: readonly ReverseSemanticsOperation[] = []
): ReverseSemanticsContract {
  return createReverseSemanticsContract({ adds, removes });
}
