import process from "node:process";

let documentationFetchAttempted = false;

globalThis.fetch = () => {
  documentationFetchAttempted = true;

  throw new Error("Documentation build refused an external fetch");
};

process.on("exit", () => {
  if (documentationFetchAttempted) {
    process.exitCode = 1;
  }
});
