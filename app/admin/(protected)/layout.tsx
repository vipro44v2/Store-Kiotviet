import { redirect } from "next/navigation";
import { AdminChrome } from "@/components/admin/admin-chrome";
import { isAuthenticated } from "@/lib/auth/session";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAuthenticated())) redirect("/admin/login");
  return <AdminChrome>{children}</AdminChrome>;
}
