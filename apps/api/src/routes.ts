import { Router } from "express";
import analyticsRoutes from "./analytics-routes.js";
import authRoutes from "./auth-routes.js";
import catalogueRoutes from "./catalogue-routes.js";
import commercialRoutes from "./commercial-routes.js";
import companyRoutes from "./company-routes.js";
import operationsRoutes from "./operations-routes.js";
import procurementRoutes from "./procurement-routes.js";
import riskRoutes from "./risk-routes.js";

const routes = Router();

routes.use("/auth", authRoutes);
routes.use(companyRoutes);
routes.use(catalogueRoutes);
routes.use(procurementRoutes);
routes.use(operationsRoutes);
routes.use(commercialRoutes);
routes.use(riskRoutes);
routes.use(analyticsRoutes);

routes.use((_request, response) => {
  response.status(404).json({ error: "المسار المطلوب غير موجود.", code: "ROUTE_NOT_FOUND" });
});

export default routes;
