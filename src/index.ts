import { Probot } from "probot";
import { prProcessor } from "./services/prProcessor.js";
import 'dotenv/config';

export default (app: Probot) => {
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    app.log.info("Received pull_request event");
    await prProcessor.processPR(context);
  });
};
