import { LoginForm } from "@/components/admin/login-form";
import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth/session";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/admin");
  return (
    <main className="login-page">
      <section>
        <div className="login-brand"><span className="brand-mark">SK</span><strong>Sync Console</strong></div>
        <p className="eyebrow">Secure administration</p>
        <h1>Welcome back</h1>
        <p>Sign in to manage Shopify and KiotViet synchronization.</p>
        <LoginForm />
      </section>
    </main>
  );
}
