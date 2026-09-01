import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth/session";

export default async function Home() {
  redirect((await isAuthenticated()) ? "/admin" : "/admin/login");
}
