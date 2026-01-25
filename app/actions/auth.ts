"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

export async function login(formData: FormData) {
  try {
    const supabase = await createClient()
    
    const email = formData.get("email") as string
    const password = formData.get("password") as string

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      // Handle Supabase service errors
      if (error.message.includes("520") || error.message.includes("fetch")) {
        return { error: "Authentication service temporarily unavailable. Please try again in a few minutes." }
      }
      return { error: error.message }
    }

    revalidatePath("/", "layout")
    redirect("/library")
  } catch (e) {
    // Handle network/server errors
    return { error: "Connection error. Please check your internet and try again." }
  }
}

export async function signup(formData: FormData) {
  try {
    const supabase = await createClient()
    
    const email = formData.get("email") as string
    const password = formData.get("password") as string

    const { error } = await supabase.auth.signUp({
      email,
      password,
    })

    if (error) {
      if (error.message.includes("520") || error.message.includes("fetch")) {
        return { error: "Authentication service temporarily unavailable. Please try again in a few minutes." }
      }
      return { error: error.message }
    }

    revalidatePath("/", "layout")
    redirect("/auth/check-email")
  } catch (e) {
    return { error: "Connection error. Please check your internet and try again." }
  }
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath("/", "layout")
  redirect("/auth/login")
}
