import { getActiveProject, approveTraining } from "./server/module-db";

async function run() {
  const active = await getActiveProject();
  if (active) {
    console.log("Re-approving training for", active.projectKey);
    await approveTraining(active.projectKey);
    console.log("Done");
  } else {
    console.log("No active project found to recompile.");
  }
}

run().catch(console.error);
