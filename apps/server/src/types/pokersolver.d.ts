declare module 'pokersolver' {
  interface SolverCard {
    toString(): string;
  }

  interface SolverHand {
    name: string;
    descr: string;
    rank: number;
    cards: SolverCard[];
  }

  interface HandStatic {
    solve(cards: string[], game?: string, canDisqualify?: boolean): SolverHand;
    winners(hands: SolverHand[]): SolverHand[];
  }

  const pokersolver: { Hand: HandStatic };
  export default pokersolver;
}
