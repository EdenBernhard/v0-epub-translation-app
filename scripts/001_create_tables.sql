-- Create users table for authentication
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create epub_files table to store uploaded EPUBs
CREATE TABLE IF NOT EXISTS public.epub_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  original_filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  source_language TEXT DEFAULT 'en',
  upload_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create translations table to store German translations
CREATE TABLE IF NOT EXISTS public.translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epub_file_id UUID NOT NULL REFERENCES public.epub_files(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  translated_content JSONB NOT NULL,
  target_language TEXT DEFAULT 'de',
  translation_status TEXT DEFAULT 'completed',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.epub_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;

-- RLS Policies for users table
CREATE POLICY "Users can view their own data" ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can insert their own data" ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- RLS Policies for epub_files table
CREATE POLICY "Users can view their own EPUBs" ON public.epub_files
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own EPUBs" ON public.epub_files
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own EPUBs" ON public.epub_files
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own EPUBs" ON public.epub_files
  FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for translations table
CREATE POLICY "Users can view their own translations" ON public.translations
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own translations" ON public.translations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own translations" ON public.translations
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own translations" ON public.translations
  FOR DELETE USING (auth.uid() = user_id);
