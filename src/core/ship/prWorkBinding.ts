/** The exact change and PR a requester accepted in a Ship work question. */
export interface PrWorkBinding {
  kind: "ship_pr_work";
  repo: string;
  pr: number;
  objective: string;
}
