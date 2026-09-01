import { LoginForm } from "@/components/admin/login-form";
import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth/session";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/admin");
  return (
    <main className="login-page">
      <section>
        <p className="eyebrow">Secure administration</p>
        <h1>Shopify KiotViet Sync</h1>
        <p>Sign in to manage synchronization.</p>
        <LoginForm />
      </section>
    </main>
  );
}
