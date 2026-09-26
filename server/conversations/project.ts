export type ApprovedProjectSnapshot = {
  id: string;
  version: number;
  businessName: string;
  packageName: string;
  packageDescription: string;
  included: string[];
  excluded: string[];
  priceLkr: number;
  depositPercent: number;
  timelineBusinessDays: string;
  revisionPolicy: string;
  requiredClientInputs: string[];
  paymentTerms: string;
  tone: string;
  forbiddenTopics: string[];
  samples: string;
  contactDetails: string;
  faqs?: string;
  escalationRules?: string;
};

export const approvedRestaurantProject: ApprovedProjectSnapshot = {
  id: "project_restaurant_website_v3",
  version: 3,
  businessName: "Anuradha Web Studio",
  packageName: "Restaurant Website Package",
  packageDescription: "A polished mobile-friendly website for a restaurant or cafe with menu, gallery, contact details, and location sections.",
  included: ["mobile-friendly website", "menu section", "photo gallery", "contact section", "Google Maps location", "basic SEO setup"],
  excluded: ["online ordering", "payment gateway", "ongoing social media management", "domain registration fees"],
  priceLkr: 85000,
  depositPercent: 40,
  timelineBusinessDays: "14–18 business days",
  revisionPolicy: "Two rounds of revisions are included after the first design preview.",
  requiredClientInputs: ["logo", "menu text", "restaurant photos", "contact details", "domain access if available"],
  paymentTerms: "A 40% deposit starts the project. The balance is due before launch.",
  tone: "warm, concise, helpful, and natural in English or Singlish",
  forbiddenTopics: ["discounts", "custom features not listed", "legal promises", "technical guarantees", "payment confirmation"],
  samples: "Portfolio samples available upon request.",
  contactDetails: "Contact the owner via WhatsApp.",
};
