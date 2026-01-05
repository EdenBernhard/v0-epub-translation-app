-- Create folders table for organizing books
CREATE TABLE IF NOT EXISTS public.folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add folder_id to epub_files table
ALTER TABLE public.epub_files
ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES public.folders(id) ON DELETE SET NULL;

-- Enable Row Level Security for folders
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;

-- RLS Policies for folders table
CREATE POLICY "Users can view their own folders" ON public.folders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own folders" ON public.folders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own folders" ON public.folders
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own folders" ON public.folders
  FOR DELETE USING (auth.uid() = user_id);

-- Create index for faster folder queries
CREATE INDEX IF NOT EXISTS idx_epub_files_folder_id ON public.epub_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_user_id ON public.folders(user_id);
