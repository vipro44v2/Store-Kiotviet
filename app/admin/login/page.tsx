import { LoginForm } from "@/components/admin/login-form";
export default function LoginPage() {
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
